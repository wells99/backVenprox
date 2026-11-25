import { randomUUID } from 'node:crypto';
import { createConnection, type RowDataPacket } from 'mysql2/promise';
import { readFileSync } from 'node:fs';
import { loadAuthDatabaseOptions } from '../packages/infrastructure/runtime/src/auth-config.js';
import { mysqlAuthRepository } from '../packages/infrastructure/mysql/src/auth-repository.js';
import { createAuthCrypto } from '../packages/infrastructure/security/src/crypto.js';
import { reportBootFailure } from '../packages/infrastructure/runtime/src/logger.js';

let stage='connect';
try {
  const connection=await createConnection(loadAuthDatabaseOptions(process.env));
  const storeId=process.env.STORE_ID!;
  const crypto=createAuthCrypto(readFileSync(process.env.AUTH_SIGNING_KEY_FILE!,'utf8'),process.env.AUTH_FINGERPRINT_KEY!);
  try {
    const [version]=await connection.query<RowDataPacket[]>('SELECT VERSION() AS version');
    const [before]=await connection.query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM auth_users');
    stage='begin'; await connection.beginTransaction();
    try {
      let active=true;
      const repo=mysqlAuthRepository(connection,storeId,()=>{if(!active)throw new Error('CLOSED');});
      stage='installation'; const installation=await repo.installation();
      if(installation.activated_at || Number(before[0]!.total)!==0) throw new Error('PROBE_REQUIRES_UNACTIVATED_INSTALLATION');
      const userId=randomUUID(),deviceId=randomUUID();
      const token=crypto.token();
      stage='user'; await repo.saveUser({id:userId,store_id:storeId,login_key:'transaction-only-proof',name:'Prova sem commit',password_hash:await crypto.hashPassword(crypto.token()),role:'operator',active:true,permissions_version:1,version:1});
      stage='device'; await repo.saveDevice({id:deviceId,store_id:storeId,code:'PROOF-ROLLBACK',credential_hash:crypto.digest(token),active:true,version:1});
      stage='session'; await repo.saveSession({id:randomUUID(),store_id:storeId,user_id:userId,access_hash:crypto.digest(crypto.token()),refresh_hash:crypto.digest(crypto.token()),csrf_hash:crypto.digest(crypto.token()),access_expires:new Date(Date.now()+900000).toISOString(),refresh_expires:new Date(Date.now()+3600000).toISOString(),revoked_at:null});
      stage='grant'; await repo.saveGrant({id:randomUUID(),store_id:storeId,user_id:userId,device_id:deviceId,issued_at:new Date().toISOString(),expires_at:new Date(Date.now()+900000).toISOString(),permissions_version:1,revoked_at:null});
      stage='verify';
      const user=await repo.user(userId),device=await repo.deviceByCredential(crypto.digest(token)),permissions=await repo.rolePermissions('operator');
      if(!user?.active || !device?.active || !permissions.includes('catalog.read')) {
        console.log(JSON.stringify({user_found:Boolean(user),user_active:Boolean(user?.active),device_found:Boolean(device),device_active:Boolean(device?.active),permission_count:permissions.length}));
        throw new Error('PROBE_FAILED');
      }
      active=false;
    } finally { await connection.rollback(); }
    const [after]=await connection.query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM auth_users');
    if(Number(after[0]!.total)!==Number(before[0]!.total))throw new Error('ROLLBACK_FAILED');
    console.log(JSON.stringify({engine:String(version[0]?.version),auth_repository:true,rollback:true,created_accounts:0,credentials_redacted:true}));
  } finally { await connection.end(); }
} catch(error) {
  const code=error && typeof error==='object' && 'code' in error && /^[A-Z_0-9]+$/.test(String(error.code)) ? String(error.code) : 'PROBE_FAILED';
  console.log(JSON.stringify({stage,code,credentials_redacted:true}));
  reportBootFailure('mariadb-auth-proof',error);
}
