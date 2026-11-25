import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
test('B13 três SQLite, duas APIs HTTP, IDs/caixas/estoque/recibos e caixa bloqueado isolado',{skip:!process.env.MYSQL_PASSWORD,timeout:180000},async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','scripts/benchmark-b13.ts'],{env:{...process.env,B13_LOAD_OPERATIONS:'90'},windowsHide:true,maxBuffer:2*1024*1024});
  const line=stdout.trim().split(/\r?\n/).at(-1)!;
  const value=JSON.parse(line) as {operations:number;separate_sqlites:number;api_instances:number;verified:{ids:boolean;cash_by_session:boolean;stock_ledger:boolean;receipts:boolean;no_local_pending:boolean}};
  assert.equal(value.operations,90);assert.equal(value.separate_sqlites,3);assert.equal(value.api_instances,2);assert.ok(Object.values(value.verified).every(Boolean));
});
