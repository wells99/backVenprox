import { validMoney } from './catalog-stock.js';
export interface PricedLine {id:string;price_cents:number;quantity_milli:number;item_discount_cents:number}
const max=BigInt(Number.MAX_SAFE_INTEGER);
export function lineSubtotal(price:number,quantity:number):number|undefined {
  if(!validMoney(price)||!Number.isSafeInteger(quantity)||quantity<=0)return undefined;
  // BigInt evita perda intermediária; só converte o resultado após conferir a faixa.
  const result=(BigInt(price)*BigInt(quantity)+500n)/1000n;return result>max?undefined:Number(result);
}
export function priceSale(lines:readonly PricedLine[],discount:number){
  if(!validMoney(discount)||!lines.length||lines.length>50||new Set(lines.map((line)=>line.id)).size!==lines.length)return {error:'INVALID_SALE_ITEMS'} as const;
  const bases:bigint[]=[],subtotals:number[]=[];
  for(const line of lines){const subtotal=lineSubtotal(line.price_cents,line.quantity_milli);if(subtotal===undefined||!validMoney(line.item_discount_cents)||line.item_discount_cents>subtotal)return {error:'INVALID_SALE_AMOUNT'} as const;subtotals.push(subtotal);bases.push(BigInt(subtotal-line.item_discount_cents));}
  const subtotal=subtotals.reduce((sum,n)=>sum+BigInt(n),0n),base=bases.reduce((sum,n)=>sum+n,0n),total=base-BigInt(discount);
  if(subtotal>max||total<=0n||total>max)return {error:'INVALID_SALE_TOTAL'} as const;
  const shares=bases.map((n)=>BigInt(discount)*n/base),remainders=bases.map((n)=>BigInt(discount)*n%base);
  let residual=BigInt(discount)-shares.reduce((sum,n)=>sum+n,0n);
  const order=lines.map((line,index)=>({id:line.id,index})).sort((a,b)=>remainders[a.index]===remainders[b.index]?(a.id<b.id?-1:1):remainders[a.index]!>remainders[b.index]!?-1:1);
  for(const line of order){if(residual===0n)break;shares[line.index]=shares[line.index]!+1n;residual--;}
  return {subtotal_cents:Number(subtotal),discount_cents:Number(subtotal-total),sale_discount_cents:discount,total_cents:Number(total),lines:lines.map((line,index)=>({id:line.id,subtotal_cents:subtotals[index]!,item_discount_cents:line.item_discount_cents,sale_discount_cents:Number(shares[index]!),total_cents:Number(bases[index]!-shares[index]!)}))};
}
export interface ManualPayment {id:string;method:'cash'|'credit'|'debit'|'pix';applied_cents:number;tendered_cents:number;change_cents:number}
export function validPayments(payments:readonly ManualPayment[],total:number):boolean {
  if(!payments.length||payments.length>10||new Set(payments.map((p)=>p.id)).size!==payments.length)return false;
  let sum=0n,tendered=0n,change=0n;
  for(const p of payments){if(!['cash','credit','debit','pix'].includes(p.method)||!validMoney(p.applied_cents)||!p.applied_cents||!validMoney(p.tendered_cents)||!validMoney(p.change_cents)||BigInt(p.tendered_cents)-BigInt(p.change_cents)!==BigInt(p.applied_cents)||p.method!=='cash'&&p.change_cents!==0)return false;sum+=BigInt(p.applied_cents);tendered+=BigInt(p.tendered_cents);change+=BigInt(p.change_cents);}
  return sum===BigInt(total)&&tendered<=max&&change<=max;
}
