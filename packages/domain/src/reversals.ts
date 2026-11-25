import { validMoney } from './catalog-stock.js';
export const paymentMethods=['cash','credit','debit','pix'] as const;
export function refundTotal(payments:readonly {id:string;method:string;amount_cents:number}[]):bigint|undefined {
  if(!payments.length||payments.length>10||new Set(payments.map((p)=>p.id)).size!==payments.length)return undefined;
  if(payments.some((p)=>!paymentMethods.includes(p.method as typeof paymentMethods[number])||!validMoney(p.amount_cents)||p.amount_cents===0))return undefined;
  return payments.reduce((sum,p)=>sum+BigInt(p.amount_cents),0n);
}
export function cashDifference(expected:Record<string,number>,counted:Record<string,number>){
  const result:Record<typeof paymentMethods[number],number>={cash:0,credit:0,debit:0,pix:0};
  if(!counted||typeof counted!=='object'||Object.keys(counted).length!==4)return undefined;
  for(const method of paymentMethods){if(!validMoney(counted[method]))return undefined;const delta=BigInt(counted[method]!)-BigInt(expected[method]!);if(delta>BigInt(Number.MAX_SAFE_INTEGER)||delta<BigInt(-Number.MAX_SAFE_INTEGER))return undefined;result[method]=Number(delta);}return result;
}
