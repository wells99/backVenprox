import assert from 'node:assert/strict';
import type { BusinessDependencies, BusinessRepository, BusinessTransaction } from '../packages/application/src/business-ports.js';
import { ApplicationError } from '../packages/application/src/application-error.js';
export async function everyWriteRollback(deps:BusinessDependencies,snapshot:()=>Promise<unknown>,execute:(deps:BusinessDependencies)=>Promise<unknown>){
  const before=await snapshot();let failedWrites=0;
  for(let failAt=1;failAt<=50;failAt++){
    let writes=0;const fault:BusinessDependencies={...deps,unitOfWork:{run:(work)=>deps.unitOfWork.run(async(tx)=>{
      const after=()=>{if(++writes===failAt)throw new ApplicationError('INJECTED_FAILURE','Falha de teste.','unavailable');};
      const business=new Proxy(tx.business,{get(target,key){const value=target[key as keyof BusinessRepository];return typeof value==='function'?async(...args:unknown[])=>{const result=await (value as (...args:unknown[])=>Promise<unknown>).apply(target,args);if(/^(insert|save|replace|append|bump|close)/.test(String(key)))after();return result;}:value;}});
      const wrap=(port:'sequences'|'outbox'|'audit')=>new Proxy(tx[port],{get(target,key){const fn=Reflect.get(target,key);return async(...args:unknown[])=>{const result=await fn.apply(target,args);after();return result;};}});
      const result=await work({...tx,business,sequences:wrap('sequences'),outbox:wrap('outbox'),audit:wrap('audit')} as BusinessTransaction);after();return result;
    })}};
    try{const result=await execute(fault);assert.ok(failedWrites>3);return {result,failedWrites};}catch(error){assert.ok(error instanceof ApplicationError&&error.code==='INJECTED_FAILURE');failedWrites++;assert.deepEqual(await snapshot(),before,`Escrita ${failAt}`);}
  }throw new Error('UNBOUNDED_WRITE_COUNT');
}
