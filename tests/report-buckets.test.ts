import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportBuckets } from '../packages/application/src/report-buckets.js';
test('B14 faixas horárias separam hora repetida no fim do horário de verão e preservam centavos',()=>{
 const range={from:'2026-11-01T04:00:00.000Z',to:'2026-11-01T08:00:00.000Z',time_zone:'America/New_York',group:'hour' as const},rows=[{minute:'2026-11-01T05:15',sales_cents:'101',refunds_cents:'0'},{minute:'2026-11-01T06:15',sales_cents:'0',refunds_cents:'101'}],r=reportBuckets(rows,range);
 assert.equal(r.bucket_coverage,'complete');assert.equal(r.buckets.length,2);assert.notEqual(r.buckets[0]!.key,r.buckets[1]!.key);assert.equal(r.buckets.reduce((n,b)=>n+b.net_cents,0),0);assert.equal(r.buckets[0]!.from,'2026-11-01T05:15:00.000Z');
 const day=reportBuckets(rows,{...range,group:'day'});assert.equal(day.buckets.length,1);assert.equal(day.buckets[0]!.sales_cents,101);assert.equal(day.buckets[0]!.refunds_cents,101);
});
test('B14 gráficos limitados não truncam silenciosamente e intervalos respeitam os filtros',()=>{
 const row={minute:'2026-11-25T12:00',sales_cents:'100',refunds_cents:'0'},range={from:'2026-11-25T12:00:10.000Z',to:'2026-11-25T12:00:20.000Z',time_zone:'America/Sao_Paulo'};
 assert.deepEqual(reportBuckets(Array.from({length:5001},()=>row),range),{bucket_coverage:'limit_exceeded',buckets:[]});const r=reportBuckets([row],range);assert.equal(r.buckets[0]!.from,range.from);assert.equal(r.buckets[0]!.to,range.to);
 assert.throws(()=>reportBuckets([{...row,sales_cents:'9007199254740992'}],range),{code:'REPORT_OUT_OF_RANGE'});
});
