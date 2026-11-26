import type { ReadRange } from './read-ports.js';
import { ApplicationError } from './application-error.js';
export function reportBuckets(rows:{minute:string;sales_cents:string;refunds_cents:string}[],range:ReadRange){
 const safe=(n:bigint)=>{if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<BigInt(-Number.MAX_SAFE_INTEGER))throw new ApplicationError('REPORT_OUT_OF_RANGE','Total fora da faixa suportada.','content');return Number(n);};
 if(rows.length>5000)return {bucket_coverage:'limit_exceeded' as const,buckets:[]};
 const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:range.time_zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23',timeZoneName:'shortOffset'}),map=new Map<string,{key:string;label:string;from:string;to:string;sales:bigint;refunds:bigint}>();
 for(const row of rows){const at=row.minute+':00.000Z',parts=formatter.formatToParts(new Date(at)),part=(kind:string)=>parts.find((p)=>p.type===kind)!.value,date=[part('year'),part('month'),part('day')].join('-'),key=range.group==='hour'?`${date} ${part('hour')}h ${part('timeZoneName')}`:date,label=range.group==='hour'?key:`${part('day')}/${part('month')}/${part('year')}`,from=new Date(Math.max(Date.parse(at),Date.parse(range.from))).toISOString(),to=new Date(Math.min(Date.parse(at)+60000,Date.parse(range.to))).toISOString(),bucket=map.get(key)??{key,label,from,to,sales:0n,refunds:0n};bucket.sales+=BigInt(row.sales_cents);bucket.refunds+=BigInt(row.refunds_cents);if(from<bucket.from)bucket.from=from;if(to>bucket.to)bucket.to=to;map.set(key,bucket);}
 return {bucket_coverage:'complete' as const,buckets:[...map.values()].sort((a,b)=>a.from.localeCompare(b.from)).map(({sales,refunds,...b})=>({...b,sales_cents:safe(sales),refunds_cents:safe(refunds),net_cents:safe(sales-refunds)}))};
}
