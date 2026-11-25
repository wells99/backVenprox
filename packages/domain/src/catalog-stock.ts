export const units = ['unit','kg','g','liter','milliliter','box','pack'] as const;
export type Unit = typeof units[number];
export type StockPolicy = 'permissive' | 'require_stock';
export function catalogText(value:unknown,max=120,multiline=false):string|undefined {
  if(typeof value!=='string')return undefined;
  const text=value.normalize('NFC').trim().replace(/\r\n?/g,'\n');
  if(!text||[...text].length>max||/[\p{Cc}\p{Cf}]/u.test(multiline?text.replaceAll('\n',''):text))return undefined;
  return text;
}
export const catalogSearchKey=(value:string)=>value.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
export function validMoney(value: unknown): value is number { return typeof value==='number' && Number.isSafeInteger(value) && value>=0; }
export function validQuantity(value: unknown, unit: Unit, allowNegative = false, allowZero = false): value is number {
  return typeof value==='number' && Number.isSafeInteger(value) && (allowNegative || value>=0) && (allowZero || value!==0)
    && (!['unit','box','pack'].includes(unit) || value%1000===0);
}
export function sumQuantity(values: readonly number[]): number | undefined {
  if(values.some((value)=>!Number.isSafeInteger(value)))return undefined;
  const total=values.reduce((result,value)=>result+BigInt(value),0n);
  return total>BigInt(Number.MAX_SAFE_INTEGER)||total<BigInt(Number.MIN_SAFE_INTEGER)?undefined:Number(total);
}
export function stockRequirements(policy: StockPolicy, lines: readonly {product_id:string|null;quantity_milli:number}[]) {
  const totals=new Map<string,number>();
  for(const line of lines) {
    if(!Number.isSafeInteger(line.quantity_milli)||line.quantity_milli<=0)return {error:'INVALID_QUANTITY'} as const;
    if(!line.product_id) {if(policy==='require_stock')return {error:'PRODUCT_REQUIRED'} as const;continue;}
    const total=sumQuantity([totals.get(line.product_id)??0,line.quantity_milli]);
    if(total===undefined)return {error:'QUANTITY_OUT_OF_RANGE'} as const;
    totals.set(line.product_id,total);
  }
  return {totals};
}
