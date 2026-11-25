import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createConnection, type RowDataPacket } from 'mysql2/promise';
import { MysqlStore } from '../packages/infrastructure/mysql/src/store.js';
import { SqliteStore } from '../packages/infrastructure/sqlite/src/store.js';
import { loadAuthDatabaseOptions } from '../packages/infrastructure/runtime/src/auth-config.js';
import { loadPersistenceConfig } from '../packages/infrastructure/runtime/src/config.js';
import { reportBootFailure } from '../packages/infrastructure/runtime/src/logger.js';
import { mysqlMigrations } from '../migrations/mysql/registry.js';
// Atualização explícita, sem setup, credenciais novas ou dados de demonstração.
try{
  const remote=process.argv.includes('--remote'),expected=Number(process.argv.at(-1));
  assert.equal(expected,mysqlMigrations.at(-1)!.version);
  const local=remote?undefined:loadPersistenceConfig(process.env),options=remote?loadAuthDatabaseOptions(process.env):local!.mysql,storeId=remote?process.env.STORE_ID!:local!.identity.store_id;
  if(!remote)assert.ok(options.host==='127.0.0.1'&&options.port===3308&&options.database==='venprox_b03');
  const connection=await createConnection(options),store=await MysqlStore.connect(options,{store_id:storeId});
  try {
  const [identity]=await connection.query<RowDataPacket[]>('SELECT store_id FROM instance_identity WHERE singleton=1');
  assert.equal(identity[0]?.store_id,storeId,'INSTALLATION_SCOPE_MISMATCH');
  const [history]=await connection.query<RowDataPacket[]>("SELECT MAX(version) AS version FROM schema_migrations WHERE state='applied'");
  const upgradePermissions=expected===8&&Number(history[0]?.version)===7;
  const upgradedRoles=new Set<string>();
  const snapshot=async(afterMigration=false)=>{
    const [tables]=await connection.query<RowDataPacket[]>('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
    const data:Record<string,unknown>={};
    for(const table of tables.map((row)=>String(row.TABLE_NAME)).filter((name)=>name!=='schema_migrations').sort()){
      assert.match(table,/^[a-z_]+$/);const [rows]=await connection.query<RowDataPacket[]>(`SELECT * FROM ${table}`);
      data[table]=rows.map((row)=>{
        const value={...row};
        if(upgradePermissions&&table==='auth_roles'&&value.role==='admin'){
          const permissions=(Array.isArray(value.permissions)?value.permissions:JSON.parse(String(value.permissions))) as string[];
          if(!afterMigration&&!permissions.includes('sales.discount'))upgradedRoles.add(String(value.store_id));
          if(afterMigration&&upgradedRoles.has(String(value.store_id))){assert.ok(permissions.includes('sales.discount'));value.version=Number(value.version)-1;}
          value.permissions=JSON.stringify(permissions.filter((p)=>p!=='sales.discount').sort());
        }
        if(upgradePermissions&&afterMigration&&table==='auth_users'&&value.role==='admin')value.permissions_version=Number(value.permissions_version)-1;
        return JSON.stringify(value);
      }).sort();
    }
    return Object.fromEntries(Object.entries(data).map(([table,rows])=>[table,createHash('sha256').update(JSON.stringify(rows)).digest('hex')]));
  };
    const before=await snapshot();await store.migrate();const after=await snapshot(true);for(const [table,digest] of Object.entries(before))assert.equal(after[table],digest,`PRESERVE_${table}`);
    if(remote){const [rows]=await connection.query<RowDataPacket[]>('SELECT activated_at,offline_ttl_seconds FROM auth_installation WHERE store_id=?',[storeId]);assert.ok(rows[0]?.activated_at);assert.equal(Number(rows[0]?.offline_ttl_seconds),0);const [admins]=await connection.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM auth_users WHERE store_id=? AND role='admin' AND active=1",[storeId]);assert.ok(Number(admins[0]?.n)>0);}
    console.log(JSON.stringify({target:remote?'external':'local_mysql',schema_version:(await store.status()).schema_version,existing_data_preserved:true,admin_discount_permission_migrated:upgradePermissions,...(remote?{activated_admin_preserved:true,offline_enabled:false}:{})}));
  }finally{await connection.end();await store.close();}
  if(local){const sqlite=SqliteStore.open(local.path,local.identity,false,true);try{const before=sqlite.database.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name NOT LIKE \'sqlite_%\' AND name<>\'schema_migrations\' ORDER BY name').all() as {name:string}[];
    const digest=(table:string)=>{assert.match(table,/^[a-z_]+$/);return createHash('sha256').update(JSON.stringify(sqlite.database.prepare(`SELECT * FROM ${table}`).all().map((row)=>JSON.stringify(row)).sort())).digest('hex');};
    const saved=before.map(({name})=>[name,digest(name)] as const);await sqlite.migrate();for(const [name,hash] of saved)assert.equal(digest(name),hash,`PRESERVE_${name}`);console.log(JSON.stringify({target:'local_sqlite',schema_version:sqlite.status().schema_version,existing_tables_preserved:true}));
  }finally{await sqlite.close();}}
}catch(error){reportBootFailure('migrate-financial',error);}
