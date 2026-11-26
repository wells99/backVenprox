import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createConnection, type ConnectionOptions } from 'mysql2/promise';
import { SqliteStore } from '../packages/infrastructure/sqlite/src/store.js';
import { MysqlStore } from '../packages/infrastructure/mysql/src/store.js';
import { sqliteBusinessUnitOfWork } from '../packages/infrastructure/sqlite/src/business.js';
import { mysqlBusinessUnitOfWork } from '../packages/infrastructure/mysql/src/business.js';
import { businessHash } from '../packages/infrastructure/persistence/src/business-repository.js';
import { permissions } from '../packages/domain/src/authorization.js';
import type { BusinessContext, BusinessDependencies } from '../packages/application/src/business-ports.js';
import { CatalogService } from '../packages/application/src/catalog-service.js';
import { CashService } from '../packages/application/src/cash-service.js';
import { StockService } from '../packages/application/src/stock-service.js';
import { ApplicationError } from '../packages/application/src/application-error.js';
import { mysqlMigrations } from '../migrations/mysql/registry.js';
import { sqliteMigrations } from '../migrations/sqlite/registry.js';
export const financialNow='2026-11-25T12:00:00.000Z';
export const fails=(code:string)=>(error:unknown)=>error instanceof ApplicationError&&error.code===code;
export async function financialFixture(engine:'sqlite'|'mysql',stage:'b07'|'b08'|'b08_ipc'|'b09'|'b10'|'b11'|'b12'|'b13'|'b13_load'|'b12_final'|'b12_ipc'|'b14'|'b14_ui'|'b18'|'b14_ui_fix',version?:number){
  const directory=await mkdtemp(join(tmpdir(),`venprox-${stage}-`)),identity={store_id:randomUUID(),device_id:randomUUID()};
  const database=`venprox_${stage}_test`;
  const options:ConnectionOptions={host:'127.0.0.1',port:3308,user:'venprox_migration',password:process.env.MYSQL_PASSWORD!,database};
  async function clear(){assert.ok(['venprox_b07_test','venprox_b08_test','venprox_b08_ipc_test','venprox_b09_test','venprox_b10_test','venprox_b11_test','venprox_b12_test','venprox_b13_test','venprox_b13_load_test','venprox_b12_final_test','venprox_b12_ipc_test','venprox_b14_test','venprox_b14_ui_test','venprox_b18_test','venprox_b14_ui_fix_test'].includes(database));const c=await createConnection(options);try{for(const table of [...new Set(mysqlMigrations.flatMap((m)=>m.steps).filter((s)=>s.sql.startsWith('CREATE TABLE')).map((s)=>s.table))].reverse())await c.query(`DROP TABLE IF EXISTS ${table}`);await c.query('DROP TABLE IF EXISTS schema_migrations');}finally{await c.end();}}
  if(engine==='mysql'){assert.equal(process.env.MYSQL_HOST,'127.0.0.1');assert.equal(process.env.MYSQL_PORT,'3308');await clear();}
  const store=engine==='sqlite'?SqliteStore.open(join(directory,'terminal.db'),identity,true):await MysqlStore.connect(options,{store_id:identity.store_id});
  await store.migrate((engine==='sqlite'?sqliteMigrations:mysqlMigrations).slice(0,version));await store.provisionIdentity();
  const base=store instanceof SqliteStore?sqliteBusinessUnitOfWork(store):mysqlBusinessUnitOfWork(store);
  // SQLite fixtures simulate accepted catalog records, not a remote publisher.
  const unitOfWork:BusinessDependencies['unitOfWork']=store instanceof SqliteStore?{run:(work)=>base.run((tx)=>work({...tx,publication:{publish:async()=>{}}}))}:base;
  const deps:BusinessDependencies={unitOfWork,storeId:identity.store_id,deviceId:identity.device_id,local:true,remoteWritesEnabled:false,clock:{now:()=>new Date(financialNow)},ids:{generate:randomUUID},hash:businessHash};
  const context:BusinessContext={...identity,user_id:randomUUID(),permissions,permissions_version:1,authorization_id:randomUUID(),authorization_origin:'online',authorized_at:financialNow,expires_at:'2026-11-26T12:00:00.000Z'};
  return {directory,store,options,identity,deps,context,cash:new CashService(deps),stock:new StockService(deps),catalog:new CatalogService({...deps,local:false,remoteWritesEnabled:true}),
    async rows(table:string):Promise<Record<string,unknown>[]>{assert.ok(/^[a-z_]+$/.test(table));if(store instanceof SqliteStore)return store.database.prepare(`SELECT * FROM ${table}`).all() as Record<string,unknown>[];const c=await createConnection(options);try{const [rows]=await c.query(`SELECT * FROM ${table}`);return rows as Record<string,unknown>[];}finally{await c.end();}},
    async count(table:string){assert.ok(/^[a-z_]+$/.test(table));if(store instanceof SqliteStore)return Number((store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n:number}).n);const c=await createConnection(options);try{const [rows]=await c.query(`SELECT COUNT(*) AS n FROM ${table}`);return Number((rows as {n:number}[])[0]!.n);}finally{await c.end();}},
    async close(){await store.close();if(engine==='mysql')await clear();assert.equal(await realpath(dirname(directory)),await realpath(tmpdir()));assert.ok(basename(directory).startsWith(`venprox-${stage}-`));await rm(directory,{recursive:true,force:true});}};
}
